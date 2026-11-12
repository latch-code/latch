import { Code2, LayoutGrid, Settings } from 'lucide-react'
import { AgentsMark } from '../agents/AgentAvatar.tsx'
import { Icon, type LucideIcon } from '@latch/ui'
import { waitingCount } from '../sessions.ts'
import type { ShellEntry } from './routes.ts'
import type { ShellState } from './useShellLayout.tsx'

const TABS: Partial<Record<ShellEntry, { label: string; icon: LucideIcon | 'agents' }>> = {
  sessions: { label: 'Code', icon: Code2 },
  agents: { label: '我的 Agent', icon: 'agents' },
  apps: { label: '应用', icon: LayoutGrid },
  settings: { label: '设置', icon: Settings },
}

/**
 * The root pages of a phone share a bottom bar of Code, 我的 Agent (where the Host has it), 应用 (where plugin pages are
 * applied) and 设置. A pushed page covers it.
 */
export function PhoneTabBar({ shell }: { shell: ShellState }) {
  const { entries, route, goEntry, snapshot } = shell
  return (
    <nav className="phone-tabs" aria-label="主导航">
      {entries.flatMap(entry => {
        const tab = TABS[entry]
        if (!tab) return []
        // A tab not shown carries a dot while something of its own waits; with 我的 Agent, each tab counts only its place.
        const agents = entries.includes('agents')
        const waits =
          route.entry !== entry
          && ((entry === 'sessions' && waitingCount(snapshot, agents ? 'code' : undefined) > 0)
            || (entry === 'agents' && waitingCount(snapshot, 'agents') > 0))
        return [
          <button
            key={entry}
            type="button"
            className="phone-tab"
            aria-current={route.entry === entry ? 'page' : undefined}
            onClick={() => {
              goEntry(entry)
            }}>
            {tab.icon === 'agents' ? <AgentsMark size={20} /> : <Icon icon={tab.icon} size={20} />}
            <span>{tab.label}</span>
            {waits && <span className="phone-tab-dot" aria-hidden="true" />}
          </button>,
        ]
      })}
    </nav>
  )
}
