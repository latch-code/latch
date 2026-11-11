import {
  Bot,
  Code2,
  Compass,
  FlaskConical,
  Glasses,
  Hammer,
  Library,
  Lightbulb,
  ListChecks,
  LockKeyhole,
  Newspaper,
  Package,
  Palette,
  PenLine,
  Telescope,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import type { AgentGlyph } from '@latch/protocol'
import { Hint, ICON_STROKE, StatusWord, type LucideIcon, type TileSize } from '@latch/ui'
import { GlyphTile } from '../components/BrandTile.tsx'
import type { ShellEntry } from '../shell/routes.ts'

const GLYPHS: Record<AgentGlyph, LucideIcon> = {
  glasses: Glasses,
  library: Library,
  newspaper: Newspaper,
  package: Package,
  'pen-line': PenLine,
  'flask-conical': FlaskConical,
  compass: Compass,
  hammer: Hammer,
  lightbulb: Lightbulb,
  'list-checks': ListChecks,
  palette: Palette,
  telescope: Telescope,
}

/** The Agent's glyph on the neutral plate; 通用 has the bot. */
export function AgentTile({ glyph, size = 20 }: { glyph: AgentGlyph | undefined; size?: TileSize }) {
  return <GlyphTile icon={glyph ? GLYPHS[glyph] : Bot} size={size} />
}

/** Whether a session can start on the Agent now, in a few words; the Host's reason behind ⓘ. */
export function Availability({ available, reason, offline }: { available: boolean; reason?: string | undefined; offline: boolean }) {
  if (offline)
    return (
      <span className="agent-availability" data-tone="warn">
        <WifiOff size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span>Mac 不在线</span>
      </span>
    )
  if (available) return <span className="agent-availability">可用</span>
  if (!reason)
    return (
      <span className="agent-availability" data-tone="warn">
        <StatusWord tone="warn">不可用</StatusWord>
      </span>
    )
  return (
    <Hint
      className="agent-availability"
      label="不可用"
      lead={<TriangleAlert size={12} strokeWidth={ICON_STROKE[12]} />}
      moreLabel="为什么不可用">
      {reason}
    </Hint>
  )
}

/** A device whose data scope leaves Agents out: what is locked, and the fine print behind ⓘ. */
export function LockedAgents() {
  return (
    <div className="agents-locked" role="status">
      <Hint label="这台设备看不到 Agent" lead={<LockKeyhole size={12} strokeWidth={ICON_STROKE[12]} />}>
        Agent 的指令、记忆和会话只对能读取全部数据的设备开放。在这台 Mac 的 设置 › 设备 里为这台设备打开「可以看项目文件」后可见。
      </Hint>
    </div>
  )
}

/** Code and 我的 Agent, the two places of the navigation, under 新会话 and 搜索. */
export function EntryRows({
  current,
  onEntry,
  agents = true,
}: {
  current: ShellEntry
  onEntry: (entry: ShellEntry) => void
  /** 我的 Agent is one of this device's entries. */
  agents?: boolean
}) {
  const rows: Array<{ entry: ShellEntry; label: string; icon: LucideIcon }> = [
    { entry: 'sessions', label: 'Code', icon: Code2 },
    ...(agents ? [{ entry: 'agents' as const, label: '我的 Agent', icon: Bot }] : []),
  ]
  return (
    <div className="sidebar-entries" role="group" aria-label="入口">
      {rows.map(row => (
        <button
          key={row.entry}
          type="button"
          className="sidebar-nav-row sidebar-entry"
          aria-current={current === row.entry ? 'page' : undefined}
          onClick={() => {
            onEntry(row.entry)
          }}>
          <row.icon size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>{row.label}</span>
        </button>
      ))}
    </div>
  )
}
