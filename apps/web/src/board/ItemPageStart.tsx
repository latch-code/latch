import { useEffect, useRef, useState } from 'react'
import { escapeSecurityText, type WorkItem } from '@latch/protocol'
import { Dialog } from '@latch/ui'
import { SessionComposer } from '../shell/SessionComposers.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'

/**
 * 再开一个 (开始 while it has none): the home's own input in a dialog, its text the 待办's 要求 and its project the
 * 待办's, every other control the person's. Sending starts a session of this 待办 through `POST /work/items/:id/start`
 * (`PendingSubmission.itemId`), with the input's own unknown-result retry; once the Host takes it the dialog closes and
 * the page stays. Closed unsent, the input gets back what it had.
 */
export function ItemPageStart({
  shell,
  item,
  revision,
  onStarted,
  onClose,
}: {
  shell: ShellState
  item: WorkItem
  /** The revision the page shows: the start names it, and a stale one is refused (409 `item-changed`) until sent again. */
  revision: number
  onStarted: (sessionId: string) => void
  onClose: () => void
}) {
  const { submission } = shell
  const ready = shell.inputTarget === 'new'
  const before = useRef<ShellState['route'] | null>(null)
  const since = useRef(submission.sendingMessage)
  const kept = useRef<string | null>(null)
  const [filled, setFilled] = useState(false)
  const sent = useRef(false)
  const latest = useRef({ shell, onClose, onStarted })
  latest.current = { shell, onClose, onStarted }
  // Opening moves 对话 to its start screen, where the new-session input lives, and puts it back on close.
  useEffect(() => {
    const { shell: opened } = latest.current
    before.current = opened.route
    opened.submission.setStay(true)
    opened.startNew()
    return () => {
      const { shell: now } = latest.current
      now.submission.setStay(false)
      now.submission.setItem(null)
      if (!sent.current && kept.current !== null) now.submission.setDraft(kept.current)
      const route = before.current
      if (route && !(route.entry === 'sessions' && route.start)) now.setRoute(route)
    }
  }, [item.id])
  // What the page shows is what the start names; the page reads the 待办 again after a refusal and this follows.
  useEffect(() => {
    latest.current.shell.submission.setItem({ id: item.id, revision })
  }, [item.id, revision])
  // Once the input is the new-session one: its text becomes the 要求 (what was there is kept), its project the 待办's.
  useEffect(() => {
    if (!ready || kept.current !== null) return
    kept.current = submission.draft
    submission.setDraft(item.prompt)
    if (item.projectId && submission.choice.workspaceId !== item.projectId) submission.updateChoice({ workspaceId: item.projectId })
    setFilled(true)
    // Once per opening: what the person changes afterwards is theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  // Anything that moves 对话 away from its start screen closes this.
  useEffect(() => {
    if (ready || !filled) return undefined
    const frame = requestAnimationFrame(() => {
      latest.current.onClose()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [ready, filled])
  // Refused because the 待办 changed meanwhile: read it again, so what shows (and the next send) is current.
  const refused = submission.errorCode
  useEffect(() => {
    if (refused === 'item-changed') void latest.current.shell.refresh()
  }, [refused])
  const sending = submission.sendingMessage
  useEffect(() => {
    if (!sending || sending === since.current) return
    if (sending.state !== 'accepted' || sending.submission.itemId !== item.id || !sending.sessionId) return
    sent.current = true
    latest.current.onStarted(sending.sessionId)
    latest.current.onClose()
  }, [sending, item.id])
  return (
    <Dialog open onClose={onClose} size="lg" title={escapeSecurityText(item.title)} className="work-board-new item-page-start">
      {ready && filled && (
        <div className="workbench-home-composer">
          <SessionComposer shell={shell} home />
        </div>
      )}
    </Dialog>
  )
}
