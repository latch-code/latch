import { useEffect } from 'react'
import { Dialog } from '@latch/ui'
import type { SendingMessage } from '../core/sendingMessage.ts'
import { SessionComposer } from '../shell/SessionComposers.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'

/**
 * 新建: the home's own input (text, project, folder or worktree, Harness, model, thinking, permission) in a dialog, a
 * bottom sheet on phones, with the same new-session draft as the 对话 start screen. Once the Host takes the start the
 * dialog closes and the board stays; the new card is marked. A start whose result is unknown keeps the dialog open
 * with the input's own retry and abandon.
 */
export function WorkBoardNew({
  shell,
  open,
  since,
  onClose,
  onStarted,
}: {
  shell: ShellState
  open: boolean
  /** What was being sent when the dialog opened: only a start sent after it closes the dialog. */
  since: SendingMessage | null
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const { setStay, sendingMessage } = shell.submission
  // The input sends a new session only while 对话 stands on its start screen; anything that moves it away closes this.
  const ready = shell.inputTarget === 'new'
  useEffect(() => {
    if (!open || ready) return undefined
    const frame = requestAnimationFrame(() => {
      onClose()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [open, ready, onClose])
  useEffect(() => {
    if (!open) return undefined
    setStay(true)
    return () => {
      setStay(false)
    }
  }, [open, setStay])
  useEffect(() => {
    if (!open || !sendingMessage || sendingMessage === since) return
    if (sendingMessage.state !== 'accepted' || sendingMessage.submission.sessionId !== undefined || !sendingMessage.sessionId) return
    onStarted(sendingMessage.sessionId)
    onClose()
  }, [open, since, sendingMessage, onStarted, onClose])
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="新建" className="work-board-new">
      {open && ready && (
        // The start screen's own wrapper: the composer lays its row out by this width, as it does there.
        <div className="workbench-home-composer">
          <SessionComposer shell={shell} home />
        </div>
      )}
    </Dialog>
  )
}
