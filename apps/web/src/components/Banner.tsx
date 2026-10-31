import { useState, type ReactNode } from 'react'
import { Collapse, MOTION, usePresence } from '@latch/ui'

/**
 * A notice at the top of the conversation. When its condition changes while the page watches, it opens and closes like
 * a disclosure (its height through the grid row, 180ms in and 140ms out) and keeps the words it had while it closes;
 * mounted with its condition already true (a load, or a new `scope` such as another session) it is simply there.
 */
export function Banner({ show, scope, children }: { show: boolean; scope?: string; children: ReactNode }) {
  const [kept, setKept] = useState<ReactNode>(show ? children : null)
  if (show && kept !== children) setKept(children)
  // The words stay until the fold has finished.
  const { present } = usePresence(show, MOTION.panelExit)
  const content = show ? children : present ? kept : null
  return (
    <Collapse key={scope} open={show}>
      {content !== null && <div className="banner-region">{content}</div>}
    </Collapse>
  )
}
