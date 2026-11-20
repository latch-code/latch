import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { readsProjectFiles, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import { MOTION, usePresence } from '@latch/ui'
import { useBackLayer } from '../hooks/backStack.ts'
import { markSeen, type SeenState } from '../sessions.ts'
import { reviewVersion, type PhoneReviewTarget, type ReviewProgress } from './model.ts'
import { useReviewShortcuts } from './useReviewShortcuts.ts'

const NO_PROGRESS: ReadonlyMap<string, ReviewProgress> = new Map()

/**
 * Moves focus to `element` for the next level of the stack; the keyboard ring shows only when the person came by keyboard,
 * not after a tap (a focused button would otherwise show its tooltip under the finger).
 */
export function moveFocus(element: HTMLElement | null | undefined): void {
  const keyboard = document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible')
  element?.focus({ preventScroll: true, focusVisible: keyboard })
}

/**
 * The phone's review page over the session list: which session it shows, the rows that offer it, and the way back. The
 * page holds a place in the browser's history like any pushed page. While it is open the session counts as read, as an
 * opened session does; going back gives focus to the row it came from.
 */
export function usePhoneReview({
  phone,
  snapshot,
  isUnread,
  setSeen,
}: {
  phone: boolean
  snapshot: AppSnapshot
  isUnread: (task: TaskSummary) => boolean
  setSeen: Dispatch<SetStateAction<SeenState>>
}) {
  const { device } = snapshot
  const authority = JSON.stringify([
    snapshot.host?.hostId,
    snapshot.instanceId,
    device.id,
    device.listener,
    device.status,
    device.dataScope,
    device.scopes?.toSorted(),
    snapshot.catalog?.features?.changes,
  ])
  const [state, setState] = useState(() => ({
    authority,
    target: null as PhoneReviewTarget | null,
    progress: new Map<string, ReviewProgress>(),
  }))
  const valid = state.authority === authority
  if (!valid) setState({ authority, target: null, progress: new Map() })
  const target = valid ? state.target : null
  const canView = device.scopes?.includes('view') ?? true
  const canRemember = canView && readsProjectFiles(device.dataScope)
  const summary = target ? snapshot.tasks.find(task => task.id === target.sessionId && !task.archived) : undefined
  const open = canView && phone && target !== null && summary !== undefined
  const presence = usePresence(open, MOTION.pushExit)
  const shortcuts = useReviewShortcuts(snapshot, isUnread, phone && canView, authority, valid ? state.progress : NO_PROGRESS)
  const reviews = useMemo(() => new Map([...shortcuts].map(([id, shortcut]) => [id, shortcut.label])), [shortcuts])
  /** Hold the slide-out only while the session and this device can still be shown. */
  const [shown, setShown] = useState<{ authority: string; target: PhoneReviewTarget; summary: TaskSummary }>()
  const canShowPrevious =
    canView && shown?.authority === authority && snapshot.tasks.some(task => task.id === shown.target.sessionId && !task.archived)
  if (open && target && summary && (shown?.authority !== authority || shown.target !== target || shown.summary !== summary))
    setShown({ authority, target, summary })
  else if (shown && !canShowPrevious) setShown(undefined)
  const showing = canShowPrevious ? shown : undefined

  const setTarget = useCallback(
    (next: PhoneReviewTarget | null) => {
      setState(previous => (previous.authority === authority ? { ...previous, target: next } : previous))
    },
    [authority],
  )
  const progressId = showing?.target.sessionId
  const remember = useCallback(
    (progress: ReviewProgress | null) => {
      if (!progressId || !canRemember) return
      setState(previous => {
        if (previous.authority !== authority || previous.target?.sessionId !== progressId) return previous
        if (previous.progress.get(progressId) === (progress ?? undefined)) return previous
        const next = new Map(previous.progress)
        if (progress) next.set(progressId, progress)
        else next.delete(progressId)
        return { ...previous, progress: next }
      })
    },
    [authority, canRemember, progressId],
  )

  useEffect(() => {
    const visible = new Set(snapshot.tasks.filter(task => !task.archived).map(task => task.id))
    setState(previous => {
      if (previous.authority !== authority || ![...previous.progress.keys()].some(id => !visible.has(id))) return previous
      return { ...previous, progress: new Map([...previous.progress].filter(([id]) => visible.has(id))) }
    })
  }, [authority, snapshot.tasks])

  const openId = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    openId.current = target?.sessionId
  })
  const close = useCallback(() => {
    const id = openId.current
    setTarget(null)
    if (id === undefined) return
    // Once the list is no longer inert: the shortcut pressed, or the row if the shortcut has gone.
    requestAnimationFrame(() => {
      const row =
        document.querySelector<HTMLElement>(`[data-review-task="${CSS.escape(id)}"]`)
        ?? document.querySelector<HTMLElement>(`.phone-list [data-task-id="${CSS.escape(id)}"]`)
      moveFocus(row)
    })
  }, [setTarget])

  const openReview = useCallback(
    (sessionId: string) => {
      const version = canRemember ? reviewVersion(shortcuts.get(sessionId)?.turn) : undefined
      setState(previous => {
        if (previous.authority !== authority) return previous
        const progress =
          version && previous.progress.get(sessionId)?.version !== version
            ? new Map(previous.progress).set(sessionId, { version })
            : previous.progress
        return { ...previous, target: { sessionId, scope: 'turn', level: 'changes' }, progress }
      })
    },
    [authority, canRemember, shortcuts],
  )

  useBackLayer(open, close)

  // The conversation is now read. The files have their own progress.
  const seenId = open ? summary?.id : undefined
  const seenAt = open ? summary?.updatedAt : undefined
  useEffect(() => {
    if (seenId && seenAt) setSeen(previous => markSeen(previous, seenId, seenAt))
  }, [seenId, seenAt, setSeen])

  // The session gone (deleted, or this device lost it) or a wider window: the page goes.
  if (target && !open) setTarget(null)

  return {
    reviews,
    open: openReview,
    close,
    setTarget,
    present: presence.present && showing !== undefined,
    leaving: presence.leaving,
    target: showing?.target,
    summary: showing?.summary,
    progress: valid && progressId ? state.progress.get(progressId) : undefined,
    remember,
  }
}

export type PhoneReviewState = ReturnType<typeof usePhoneReview>
