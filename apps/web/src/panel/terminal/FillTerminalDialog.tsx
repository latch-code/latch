import { useEffect, useState } from 'react'
import { Dialog } from '@latch/ui'
import { DETACHED, useFillAsk } from './fills.ts'
import { TerminalPanel } from './TerminalPanel.tsx'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    terminal: '终端',
    close: '关闭',
  },
  {
    terminal: 'Terminal',
    close: 'Close',
  },
)

/**
 * A command typed in where no session is in view (设置, first setup): the default project's terminals in a dialog, as a
 * login outside a session runs in one. Closing the dialog leaves the shells running; the home's 终端 shows the same ones.
 */
export function FillTerminalDialog({ workspaceId, unavailable }: { workspaceId: string; unavailable?: string | undefined }) {
  const ask = useFillAsk(DETACHED)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (ask) setOpen(true)
  }, [ask])
  if (!open) return null
  return (
    <Dialog
      open
      size="xl"
      className="login-terminal-dialog fill-terminal-dialog"
      title={COPY.terminal}
      closeLabel={COPY.close}
      onClose={() => setOpen(false)}>
      <div className="login-terminal-screen fill-terminal-screen">
        <TerminalPanel target={{ workspaceId }} shown requested={false} {...(unavailable ? { unavailable } : {})} fillPlace={DETACHED} />
      </div>
    </Dialog>
  )
}
