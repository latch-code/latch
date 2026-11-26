import { createContext, useContext, useMemo } from 'react'
import { FileSession } from '../components/FileChip.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'

/** Where a line of the conversation points in 改动: a turn, and within it a file. */
export interface ChangesTarget {
  turnId?: string
  root?: string
  path?: string
}

/** The conversation's way into the right panel's changes. */
export interface ChangesLink {
  open: (target: ChangesTarget) => void
  /** A turn alone can be opened: the 改动 tab is there, not only a file's history. */
  turns?: boolean
}

export const ChangesLinkContext = createContext<ChangesLink | null>(null)

/** The shell's link, or, where no shell provides one (a transcript alone), the session's per-file history. */
export function useChangesLink(): ChangesLink | null {
  const shell = useContext(ChangesLinkContext)
  const session = useContext(FileSession)
  const openFile = useContext(FileOpenContext)
  return useMemo(() => {
    if (shell) return shell
    if (!session || !openFile) return null
    return {
      open: target => {
        if (target.path)
          openFile({ sessionId: session.id, reference: target.path, ...(target.root ? { rootId: target.root } : {}), view: 'changes' })
      },
    }
  }, [shell, session, openFile])
}
