import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { MOTION, usePresence } from '@latch/ui'
import { useBackLayer } from '../hooks/backStack.ts'
import { markSeen, type SeenState } from '../sessions.ts'
import type { PhoneReviewTarget } from './model.ts'
import { useReviewShortcuts } from './useReviewShortcuts.ts'

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
  const [target, setTarget] = useState<PhoneReviewTarget | null>(null)
  const summary = target ? snapshot.tasks.find(task => task.id === target.sessionId) : undefined
  const open = phone && target !== null && summary !== undefined
  const presence = usePresence(open, MOTION.pushExit)
  const reviews = useReviewShortcuts(snapshot, isUnread, phone)
  /** The last session shown, so the page can slide away with its content. */
  const [shown, setShown] = useState<{ target: PhoneReviewTarget; summary: TaskSummary }>()
  if (phone && target && summary && (shown?.target !== target || shown.summary !== summary)) setShown({ target, summary })

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
  }, [])

  const openReview = useCallback((sessionId: string) => {
    setTarget({ sessionId, scope: 'turn', level: 'changes' })
  }, [])

  useBackLayer(open, close)

  // Looking at its changes reads the session: back on the list its row no longer offers them as new.
  const seenId = open ? summary?.id : undefined
  const seenAt = open ? summary?.updatedAt : undefined
  useEffect(() => {
    if (seenId && seenAt) setSeen(previous => markSeen(previous, seenId, seenAt))
  }, [seenId, seenAt, setSeen])

  // The session gone (deleted, or this device lost it) or a wider window: the page goes.
  if (target && (!phone || !summary)) setTarget(null)

  return {
    reviews,
    open: openReview,
    close,
    setTarget,
    present: presence.present && shown !== undefined,
    leaving: presence.leaving,
    target: shown?.target,
    summary: shown?.summary,
  }
}

export type PhoneReviewState = ReturnType<typeof usePhoneReview>
