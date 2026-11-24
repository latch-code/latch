import { SHELL_COPY } from './copy.ts'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { Icon, type IconComponent, CodeGlyph, PluginsGlyph, SettingsGlyph } from '@latch/ui'
import { waitingCount } from '../sessions.ts'
import type { ShellEntry } from './routes.ts'
import type { ShellState } from './useShellLayout.tsx'

const TABS: Record<Exclude<ShellEntry, 'marketplace'>, IconComponent> = {
  sessions: CodeGlyph,
  agents: AgentsGlyph,
  apps: PluginsGlyph,
  settings: SettingsGlyph,
}

/**
 * The root pages of a phone share a bottom bar of Code, 我的 Agent (where the Host has it), 应用 (where plugin pages are
 * applied) and 设置. A pushed page covers it.
 */
export function PhoneTabBar({ shell }: { shell: ShellState }) {
  const { entries, route, goEntry, snapshot } = shell
  return (
    <nav className="phone-tabs" aria-label={SHELL_COPY.navigation}>
      {entries.flatMap(entry => {
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
            data-entry={entry}
            data-testid={entry === 'settings' ? 'open-settings' : undefined}
            aria-current={route.entry === entry ? 'page' : undefined}
            onClick={() => {
              // Code's root page is its session list; 新会话 there opens the start screen.
              if (entry !== 'sessions') goEntry(entry)
              else {
                shell.setRoute({ entry: 'sessions' })
                if (shell.selectedId !== null) shell.choose(null)
              }
            }}>
            <Icon icon={TABS[entry]} size={20} solid={route.entry === entry} />
            <span>{entry === 'sessions' ? 'Code' : SHELL_COPY[entry]}</span>
            {waits && <span className="phone-tab-dot" aria-hidden="true" />}
          </button>,
        ]
      })}
    </nav>
  )
}
