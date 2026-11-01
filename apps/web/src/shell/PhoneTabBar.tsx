import { MessagesSquare, Settings } from 'lucide-react'
import { Icon, type LucideIcon } from '@latch/ui'
import { waitingCount } from '../sessions.ts'
import type { ShellEntry } from './routes.ts'
import type { ShellState } from './useShellLayout.tsx'

const TABS: Partial<Record<ShellEntry, { label: string; icon: LucideIcon }>> = {
  sessions: { label: '会话', icon: MessagesSquare },
  settings: { label: '设置', icon: Settings },
}

/** The root pages of a phone share a bottom bar of 会话 and 设置. A pushed page covers it. */
export function PhoneTabBar({ shell }: { shell: ShellState }) {
  const { entries, route, goEntry, snapshot } = shell
  return (
    <nav className="phone-tabs" aria-label="主导航">
      {entries.flatMap(entry => {
        const tab = TABS[entry]
        if (!tab) return []
        const waits = entry === 'sessions' && route.entry !== 'sessions' && waitingCount(snapshot) > 0
        return [
          <button
            key={entry}
            type="button"
            className="phone-tab"
            aria-current={route.entry === entry ? 'page' : undefined}
            onClick={() => {
              goEntry(entry)
            }}>
            <Icon icon={tab.icon} size={20} />
            <span>{tab.label}</span>
            {waits && <span className="phone-tab-dot" aria-hidden="true" />}
          </button>,
        ]
      })}
    </nav>
  )
}
