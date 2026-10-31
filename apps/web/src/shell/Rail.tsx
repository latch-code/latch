import { Blocks, MessagesSquare, Settings, Smartphone, AlarmClock, Bot } from 'lucide-react'
import { IconButton, type LucideIcon } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import type { RailEntry } from './routes.ts'
import type { ShellState } from './useShellLayout.tsx'

export const RAIL_LABELS: Record<RailEntry, string> = {
  sessions: '会话',
  agents: 'Agent',
  automations: '自动化',
  plugins: '插件',
  phone: '手机',
  settings: '设置',
}
export const RAIL_ICONS: Record<RailEntry, LucideIcon> = {
  sessions: MessagesSquare,
  agents: Bot,
  automations: AlarmClock,
  plugins: Blocks,
  phone: Smartphone,
  settings: Settings,
}

/** Something wrong with reaching the Mac: the sentence for the dot above 手机, and how bad it is. A healthy state has none. */
function connectionTrouble(shell: Pick<ShellState, 'connection' | 'hostProblem'>): { tone: 'warn' | 'error'; text: string } | null {
  if (shell.connection === 'offline') return { tone: 'warn', text: '这台设备已离线' }
  if (shell.hostProblem) return { tone: 'error', text: shell.hostProblem.text }
  if (shell.connection === 'reconnecting') return { tone: 'warn', text: '正在重新连接' }
  return null
}

/**
 * The 52px icon rail below the title bar, on tablets and wider. Each entry owns the panel next to it and the main area;
 * switching keeps every session's state.
 */
export function Rail({ shell }: { shell: ShellState }) {
  const { entries, route, goEntry, rail, snapshot } = shell
  const trouble = connectionTrouble(shell)
  const desktop = currentShell() !== null
  const shortcut = (entry: RailEntry) => {
    if (entry === 'settings') return desktop ? '⌘,' : 'Alt ,'
    const digit = (['sessions', 'agents', 'automations', 'plugins'] as RailEntry[]).indexOf(entry) + 1
    if (digit === 0) return undefined
    return desktop ? `⌘${digit}` : `Alt ${digit}`
  }
  const button = (entry: RailEntry) =>
    entries.includes(entry) && (
      <IconButton
        key={entry}
        className="rail-entry"
        size="md"
        label={RAIL_LABELS[entry]}
        icon={RAIL_ICONS[entry]}
        shortcut={shortcut(entry)}
        aria-current={route.entry === entry ? 'page' : undefined}
        badge={
          entry === 'sessions' && route.entry !== 'sessions' && snapshot.approvals.length > 0 ? <span className="rail-dot" /> : undefined
        }
        onClick={() => {
          goEntry(entry)
        }}
      />
    )
  return (
    <nav ref={rail} className="rail" aria-label="主导航">
      {button('sessions')}
      {button('agents')}
      {button('automations')}
      {button('plugins')}
      <span className="rail-spacer" />
      {trouble && (
        <span className="rail-trouble" data-tone={trouble.tone} role="status" title={trouble.text}>
          <span className="sr-only">{trouble.text}</span>
        </span>
      )}
      {button('phone')}
      {button('settings')}
    </nav>
  )
}
