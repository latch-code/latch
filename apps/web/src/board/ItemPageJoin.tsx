import { useSyncExternalStore } from 'react'
import { WORK_ITEM_LIMITS, type WorkItemAnswer } from '@latch/protocol'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { relativeTime } from '../format.ts'
import { hostNow } from '../core/hostClock.ts'
import { defineCopy } from '../core/i18n.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { ItemPagePick } from './ItemPagePick.tsx'
import { openItems } from './items.ts'

const COPY = defineCopy({ title: '加入待办', empty: '没有未完成的待办' }, { title: 'Add to task', empty: 'No open tasks' })

/** 加入待办… from a session's menu: which session asked, until the dialog closes. */
let asking: string | null = null
const listeners = new Set<() => void>()
const tell = () => {
  for (const listener of listeners) listener()
}
const closeJoin = () => {
  asking = null
  tell()
}

export function askJoinItem(sessionId: string): void {
  asking = sessionId
  tell()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The session leaves its 待办 (移出待办 in its menu); the session itself stays as it is. */
export async function leaveItem(shell: Pick<ShellState, 'refresh' | 'setToast'>, itemId: string, sessionId: string): Promise<void> {
  try {
    await api<WorkItemAnswer>(`work/items/${encodeURIComponent(itemId)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    await shell.refresh()
  } catch (cause) {
    shell.setToast({ text: errorMessage(cause), tone: 'error' })
  }
}

/** 加入待办…: the 待办 not marked done, newest first; picking one adds the session at once. */
export function ItemJoinDialog({ shell }: { shell: ShellState }) {
  const sessionId = useSyncExternalStore(subscribe, () => asking)
  if (sessionId === null) return null
  const now = new Date(hostNow())
  return (
    <ItemPagePick
      title={COPY.title}
      phone={shell.phone}
      empty={COPY.empty}
      options={openItems(shell.snapshot, WORK_ITEM_LIMITS.sessions).map(item => ({
        id: item.id,
        title: item.title,
        meta: relativeTime(item.updatedAt, now),
      }))}
      onPick={async itemId => {
        try {
          await api<WorkItemAnswer>(`work/items/${encodeURIComponent(itemId)}/sessions`, { method: 'POST', body: { sessionId } })
        } catch (cause) {
          throw new MessageError(errorMessage(cause))
        }
        await shell.refresh()
      }}
      onClose={closeJoin}
    />
  )
}
