import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChangedFile,
  ChangeList,
  ChangePatch,
  ChangeReceipt,
  DiscardPreview,
  DiscardResult,
  FileChangeDetail,
  TaskSummary,
  TurnChanges,
} from '@latch/protocol'
import { announceChangesWrite, onChangesWrite } from '../../conversation/useTurnChanges.ts'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { fileId, queryOf, type ScopeChoice } from './model.ts'
import { CHANGE_WRITE_COPY } from './write.copy.ts'

/** Whole-file context: the review folds what it does not show, and opens it without asking again. */
const WHOLE_FILE = 100_000
const ACTIVE = new Set(['running', 'waiting-approval'])

export type ChangesFailure =
  /** A kept turn was asked for and is gone: past the 20 kept, or never recorded. */
  | { kind: 'turn-gone' }
  /** The Host refuses this device any file of a session folder. */
  | { kind: 'denied' }
  | { kind: 'failed'; text: string }

function failureOf(cause: unknown): ChangesFailure {
  if (cause instanceof ApiError && cause.code === 'change-turn-missing') return { kind: 'turn-gone' }
  if (cause instanceof ApiError && cause.code === 'file-scope') return { kind: 'denied' }
  return { kind: 'failed', text: errorMessage(cause) }
}

/** What the last press did, shown until the scope changes, the next press or the next turn. */
export type ChangesResult =
  | { kind: 'turn'; receipt: ChangeReceipt }
  | { kind: 'file'; path: string; result: DiscardResult }
  | { kind: 'uncommitted'; result: DiscardResult }

export interface ChangesActions {
  undo(turnId: string): Promise<void>
  redo(turnId: string): Promise<void>
  undoFile(turnId: string, file: Pick<ChangedFile, 'root' | 'path'>): Promise<void>
  previewDiscard(): Promise<DiscardPreview>
  discard(planHash: string): Promise<void>
  patch(): Promise<ChangePatch>
}

/**
 * How long to wait before reading again while the Host's turn record and the session's status disagree: the status moves
 * first, at both ends of a turn, and recording an end walks the session's folders. Bounded, because a turn whose record
 * failed never agrees.
 */
const RECHECK_MS = [300, 600, 1200, 2400, 5000, 5000, 5000, 5000]

/**
 * The scope's list and the session's turns. A running turn keeps the last list on screen: the list refreshes when the
 * turn ends, on returning to the window and on a press, never with a skeleton. A list is only ever answered for the
 * scope that asked for it, so nothing of another scope, least of all its actions, stands under this scope's label.
 */
export function useChanges(summary: Pick<TaskSummary, 'id' | 'status' | 'runId'>, choice: ScopeChoice, offline = false) {
  const sessionId = summary.id
  const running = ACTIVE.has(summary.status)
  const [answer, setAnswer] = useState<{ key: string; list: ChangeList }>()
  const [turns, setTurns] = useState<TurnChanges[]>([])
  const [turnsRead, setTurnsRead] = useState(false)
  const [refused, setRefused] = useState<{ key: string; failure: ChangesFailure }>()
  const [busy, setBusy] = useState<'undo' | 'redo' | 'file' | 'discard' | undefined>()
  const [actionFailure, setActionError] = useState<{ cause: unknown }>()
  const actionError = actionFailure && (isUncertain(actionFailure.cause) ? CHANGE_WRITE_COPY.uncertain : errorMessage(actionFailure.cause))
  const [uncertain, setUncertain] = useState<{ action: 'undo' | 'redo'; turnId: string }>()
  const [result, setResult] = useState<ChangesResult>()
  const [undoneFiles, setUndoneFiles] = useState<ReadonlySet<string>>(new Set())
  const [revision, setRevision] = useState(0)
  /** Lists answer in the order asked: a late answer for an earlier scope or session never replaces the newer one. */
  const asked = useRef(0)
  const reading = useRef(0)
  const scopeKey = JSON.stringify([sessionId, choice])
  const base = `tasks/${encodeURIComponent(sessionId)}/changes`
  const query = queryOf(choice)
  const search = new URLSearchParams({ scope: query.scope, ...(query.turnId ? { turn: query.turnId } : {}) }).toString()
  const list = answer?.key === scopeKey ? answer.list : undefined
  const failure = refused?.key === scopeKey ? refused.failure : undefined

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const mine = ++asked.current
      reading.current = mine
      let nextTurns: TurnChanges[] | undefined
      try {
        // Turns first: a list read after them is never older, so a settled turn cannot come with a running list.
        nextTurns = (await api<{ turns: TurnChanges[] }>(`${base}/turns`, signal ? { signal } : {})).turns
        const nextList = await api<ChangeList>(`${base}?${search}`, signal ? { signal } : {})
        if (mine !== asked.current) return
        setAnswer({ key: scopeKey, list: nextList })
        setTurns(nextTurns)
        setTurnsRead(true)
        setRefused(undefined)
        setRevision(value => value + 1)
      } catch (cause) {
        if (mine !== asked.current || signal?.aborted) return
        const next = failureOf(cause)
        setRefused({ key: scopeKey, failure: next })
        // A refresh that failed keeps the list it was refreshing; a refusal means there is nothing to show.
        if (next.kind !== 'failed') setAnswer(undefined)
        if (nextTurns) {
          setTurns(nextTurns)
          setTurnsRead(true)
        }
      } finally {
        if (reading.current === mine) reading.current = 0
      }
    },
    [base, search, scopeKey],
  )
  /** A write outlives the scope it was pressed in, and must not read that scope back over the one now shown. */
  const latestLoad = useRef(load)
  useEffect(() => {
    latestLoad.current = load
  }, [load])

  const readTurns = useCallback(() => {
    void api<{ turns: TurnChanges[] }>(`${base}/turns`)
      .then(next => {
        setTurns(next.turns)
        setTurnsRead(true)
      })
      .catch(() => {})
  }, [base])

  const shownKey = useRef('')
  useEffect(() => {
    const changedScope = shownKey.current !== scopeKey
    shownKey.current = scopeKey
    if (changedScope) {
      setResult(undefined)
      setActionError(undefined)
      setUncertain(undefined)
      setUndoneFiles(new Set())
    }
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
    }
  }, [scopeKey, load])

  // The turn's end refreshes what is shown. Its start reads only the turn list, so the last list stays with its line.
  const wasRunning = useRef(running)
  const runKey = summary.runId ?? ''
  const lastRun = useRef(runKey)
  useEffect(() => {
    const before = wasRunning.current
    const newRun = lastRun.current !== runKey
    wasRunning.current = running
    lastRun.current = runKey
    // A run that began and ended between two looks at the session (the list's snapshot can skip it) ends here too.
    if ((before || newRun) && !running) void load()
    else if (running) {
      if (!before) {
        setResult(undefined)
        setUndoneFiles(new Set())
      }
      readTurns()
    }
  }, [running, runKey, readTurns, load])

  const recordRunning = turns.some(turn => turn.state === 'running')
  const disagrees = turnsRead && running !== recordRunning
  const rechecks = useRef(0)
  useEffect(() => {
    if (!disagrees) {
      rechecks.current = 0
      return undefined
    }
    const wait = RECHECK_MS[rechecks.current]
    if (wait === undefined) return undefined
    const timer = setTimeout(() => {
      // A read under way answers this, and its answer comes back here; starting another would only discard it.
      if (reading.current) return
      rechecks.current++
      if (running) readTurns()
      else void load()
    }, wait)
    return () => {
      clearTimeout(timer)
    }
  }, [disagrees, running, turns, readTurns, load])

  // A linked turn the record had not reached yet is there once its start is recorded.
  const pickedTurnKnown = choice.kind === 'turn' && turns.some(turn => turn.turnId === choice.turnId)
  const turnWasGone = failure?.kind === 'turn-gone'
  useEffect(() => {
    if (pickedTurnKnown && turnWasGone && running) void load()
  }, [pickedTurnKnown, turnWasGone, running, load])

  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline) void load()
    wasOffline.current = offline
  }, [offline, load])

  useEffect(() => {
    const returned = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', returned)
    return () => {
      window.removeEventListener('focus', returned)
    }
  }, [load])

  useEffect(
    () =>
      onChangesWrite((written, from) => {
        if (written === sessionId && from === 'conversation') void load()
      }),
    [sessionId, load],
  )

  /** A write whose answer never came keeps its request ID, so a retry cannot apply twice. */
  const unknownWrite = useRef<{ key: string; requestId: string } | null>(null)
  // The doubt ends when the Host's answer shows the write took: pressing again would then be the opposite action.
  useEffect(() => {
    if (!uncertain || list?.turnId !== uncertain.turnId || Boolean(list.undone) !== (uncertain.action === 'undo')) return
    unknownWrite.current = null
    setUncertain(undefined)
    setActionError(undefined)
  }, [uncertain, list])

  const turnWrite = useCallback(
    async (action: 'undo' | 'redo', turnId: string) => {
      const key = `${action}:${turnId}`
      const requestId = unknownWrite.current?.key === key ? unknownWrite.current.requestId : newRequestId()
      unknownWrite.current = { key, requestId }
      setBusy(action)
      setActionError(undefined)
      setUncertain(undefined)
      try {
        const receipt = await api<ChangeReceipt>(`tasks/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/${action}`, {
          method: 'POST',
          body: { requestId },
        })
        unknownWrite.current = null
        if (shownKey.current === scopeKey) {
          setResult({ kind: 'turn', receipt })
          setUndoneFiles(new Set())
        }
      } catch (cause) {
        if (!isUncertain(cause)) unknownWrite.current = null
        if (shownKey.current === scopeKey) {
          if (isUncertain(cause)) setUncertain({ action, turnId })
          setActionError({ cause })
        }
      }
      // Still busy until the list is back: the button must not come alive on the state from before the press.
      await latestLoad.current()
      announceChangesWrite(sessionId, 'panel')
      setBusy(undefined)
    },
    [sessionId, scopeKey],
  )

  // A turn's list stays on that turn while the next one starts, and each file and patch is read from the same turn.
  const shown = list?.turnId && query.scope === 'turn' ? new URLSearchParams({ scope: 'turn', turn: list.turnId }).toString() : search

  const actions: ChangesActions = {
    undo: turnId => turnWrite('undo', turnId),
    redo: turnId => turnWrite('redo', turnId),
    async undoFile(turnId, file) {
      setBusy('file')
      setActionError(undefined)
      try {
        const answer = await api<DiscardResult>(`${base}/discard`, {
          method: 'POST',
          body: { scope: 'turn', turnId, files: [{ root: file.root, path: file.path }] },
        })
        if (shownKey.current === scopeKey) {
          setResult({ kind: 'file', path: file.path, result: answer })
          setUndoneFiles(previous => new Set(previous).add(fileId(file)))
        }
      } catch (cause) {
        // Going back again finds the file already there and writes nothing, so pressing again is safe.
        if (shownKey.current === scopeKey) setActionError({ cause })
      }
      await latestLoad.current()
      announceChangesWrite(sessionId, 'panel')
      setBusy(undefined)
    },
    previewDiscard: () => api<DiscardPreview>(`${base}/discard/preview`, { method: 'POST', body: {} }),
    async discard(planHash) {
      setBusy('discard')
      setActionError(undefined)
      try {
        const answer = await api<DiscardResult>(`${base}/discard`, { method: 'POST', body: { scope: 'uncommitted', confirm: planHash } })
        if (shownKey.current === scopeKey) setResult({ kind: 'uncommitted', result: answer })
      } catch (cause) {
        await latestLoad.current()
        throw cause
      } finally {
        setBusy(undefined)
      }
      await latestLoad.current()
      announceChangesWrite(sessionId, 'panel')
    },
    patch: () => api<ChangePatch>(`${base}/patch?${shown}`),
  }

  /** One file's hunks, asked for only when it opens. */
  const readFile = useCallback(
    (file: Pick<ChangedFile, 'root' | 'path'>, signal: AbortSignal) =>
      api<FileChangeDetail>(
        `${base}/file?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(shown)), root: file.root, path: file.path, context: String(WHOLE_FILE) }).toString()}`,
        { signal },
      ),
    [base, shown],
  )

  return { list, turns, turnsRead, running, failure, busy, actionError, result, undoneFiles, revision, reload: load, actions, readFile }
}
