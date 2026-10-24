import { useCallback, useEffect, useRef, useState } from 'react'
import { api as defaultApi, ApiError, type ApiOptions } from './api.ts'

/**
 * Each browser remembers the newest audit record it has seen per Host. After a
 * reconnect it asks the Host for the hash at that position: a different hash, a
 * missing record or a shorter log means the audit file was rolled back or
 * replaced, which the page reports. Storage failures only skip the check.
 */

export interface AuditCheckpoint {
  seq: number
  hash: string
}

const storageKey = (hostId: string) => `latch.audit.${hostId}`
const dismissKey = (hostId: string) => `latch.audit.dismissed.${hostId}`

const isCheckpoint = (value: unknown): value is AuditCheckpoint =>
  typeof value === 'object'
  && value !== null
  && Number.isSafeInteger((value as AuditCheckpoint).seq)
  && (value as AuditCheckpoint).seq >= 0
  && typeof (value as AuditCheckpoint).hash === 'string'
  && /^[0-9a-f]{64}$/.test((value as AuditCheckpoint).hash)

export interface CheckpointStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readCheckpoint(hostId: string, storage: CheckpointStorage): AuditCheckpoint | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey(hostId)) ?? 'null')
    return isCheckpoint(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Tabs share the stored checkpoint, so a write never moves it back past what another tab stored meanwhile;
 * `rebase` (the owner checked the Host after a rollback) may.
 */
export function writeCheckpoint(hostId: string, checkpoint: AuditCheckpoint, storage: CheckpointStorage, rebase = false): void {
  if (!rebase && (readCheckpoint(hostId, storage)?.seq ?? -1) > checkpoint.seq) return
  try {
    storage.setItem(storageKey(hostId), JSON.stringify({ seq: checkpoint.seq, hash: checkpoint.hash }))
  } catch {
    /* The next check starts over. */
  }
}

type AuditApi = <T>(path: string, options?: ApiOptions) => Promise<T>

/** Whether the Host's log still holds `checkpoint` at its position; a 404 means the record is gone. */
async function holds(api: AuditApi, head: AuditCheckpoint, checkpoint: AuditCheckpoint): Promise<boolean> {
  if (head.seq < checkpoint.seq) return false
  if (head.seq === checkpoint.seq) return head.hash === checkpoint.hash
  try {
    return (await api<AuditCheckpoint>(`audit/hash?seq=${checkpoint.seq}`)).hash === checkpoint.hash
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false
    throw error
  }
}

export type CheckpointOutcome =
  | { result: 'ok'; head: AuditCheckpoint }
  | { result: 'rollback'; head: AuditCheckpoint; stored: AuditCheckpoint }

export async function verifyCheckpoint(hostId: string, deps: { api: AuditApi; storage: CheckpointStorage }): Promise<CheckpointOutcome> {
  // Read before asking for the head: the log only grows, so a head fetched later is never behind a checkpoint stored
  // earlier, even when another tab stores a newer one in between.
  const stored = readCheckpoint(hostId, deps.storage)
  const head = await deps.api<AuditCheckpoint>('audit/head')
  if (stored === null) {
    writeCheckpoint(hostId, head, deps.storage)
    return { result: 'ok', head }
  }
  if (!(await holds(deps.api, head, stored))) return { result: 'rollback', head, stored }
  writeCheckpoint(hostId, head, deps.storage)
  return { result: 'ok', head }
}

/** A dismissed rollback: the checkpoint it contradicted and the Host's head when it was dismissed. */
export interface RollbackDismissal {
  stored: AuditCheckpoint
  head: AuditCheckpoint
}

export function readDismissal(hostId: string, storage: CheckpointStorage | null): RollbackDismissal | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(dismissKey(hostId)) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const { stored, head } = value as Partial<RollbackDismissal>
    return isCheckpoint(stored) && isCheckpoint(head) ? { stored, head } : null
  } catch {
    return null
  }
}

export function writeDismissal(hostId: string, dismissal: RollbackDismissal, storage: CheckpointStorage | null): void {
  try {
    storage?.setItem(dismissKey(hostId), JSON.stringify(dismissal))
  } catch {
    /* Dismissed for this view only. */
  }
}

/**
 * A dismissal hides only the rollback it was made for: the same stored checkpoint, and a Host log that still extends
 * the head seen at dismissal. A log rolled back or replaced again, or a different checkpoint, shows the banner again.
 */
export async function rollbackDismissed(outcome: CheckpointOutcome, dismissal: RollbackDismissal | null, api: AuditApi): Promise<boolean> {
  if (outcome.result !== 'rollback' || dismissal === null) return false
  if (dismissal.stored.seq !== outcome.stored.seq || dismissal.stored.hash !== outcome.stored.hash) return false
  try {
    return await holds(api, outcome.head, dismissal.head)
  } catch {
    return false
  }
}

/**
 * Whether this check keeps the banner hidden. While the dismissed rollback still holds, the dismissal's reference moves
 * to the head this check saw, so a later rollback or replacement of records this tab has already seen shows the banner
 * again instead of being compared only with the head seen at dismissal.
 */
export async function keepDismissed(
  hostId: string,
  outcome: CheckpointOutcome,
  storage: CheckpointStorage | null,
  api: AuditApi,
): Promise<boolean> {
  if (outcome.result !== 'rollback' || !(await rollbackDismissed(outcome, readDismissal(hostId, storage), api))) return false
  // Overlapping checks may finish out of order; the reference only moves forward.
  const latest = readDismissal(hostId, storage)
  if (latest === null || outcome.head.seq >= latest.head.seq)
    writeDismissal(hostId, { stored: outcome.stored, head: outcome.head }, storage)
  return true
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): CheckpointStorage | null {
  try {
    return window[kind]
  } catch {
    return null
  }
}

/** Runs the check each time the connection becomes healthy. Off for Hosts without the audit API. */
export function useAuditCheckpoint(hostId: string | undefined, connected: boolean) {
  const [rollback, setRollback] = useState(false)
  const head = useRef<AuditCheckpoint | null>(null)
  const shown = useRef<RollbackDismissal | null>(null)
  useEffect(() => {
    if (hostId === undefined || !connected) return
    const storage = safeStorage('localStorage')
    if (storage === null) return
    let active = true
    void (async () => {
      const outcome = await verifyCheckpoint(hostId, { api: defaultApi, storage })
      const dismissed = await keepDismissed(hostId, outcome, safeStorage('sessionStorage'), defaultApi)
      if (!active) return
      head.current = outcome.head
      shown.current = outcome.result === 'rollback' ? { stored: outcome.stored, head: outcome.head } : null
      setRollback(outcome.result === 'rollback' && !dismissed)
    })().catch(() => {
      /* Unreachable audit endpoints leave the banner unchanged. */
    })
    return () => {
      active = false
    }
  }, [hostId, connected])

  const dismiss = useCallback(() => {
    setRollback(false)
    if (hostId !== undefined && shown.current !== null) writeDismissal(hostId, shown.current, safeStorage('sessionStorage'))
  }, [hostId])
  /** The owner checked the Host: remember its head at this moment as the new reference. */
  const accept = useCallback(() => {
    setRollback(false)
    const storage = safeStorage('localStorage')
    if (hostId === undefined || storage === null) return
    void defaultApi<AuditCheckpoint>('audit/head')
      .then(current => {
        writeCheckpoint(hostId, current, storage, true)
      })
      .catch(() => {
        if (head.current !== null) writeCheckpoint(hostId, head.current, storage, true)
      })
  }, [hostId])
  return { rollback, dismiss, accept }
}

export const AUDIT_ROLLBACK_TEXT = '此 Host 的审计记录与上次看到的不一致（可能被回滚或替换）。请在执行端电脑上检查。'
