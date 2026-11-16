import { OverviewGlyph, ScheduleGlyph } from '@latch/ui'
import type { ReactNode } from 'react'
import type { AppSnapshot } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  Icon,
  IconButton,
  SegmentedControl,
  CodeGlyph,
  PluginsGlyph,
  LaptopGlyph,
  PlusGlyph,
  SearchGlyph,
  SettingsGlyph,
  NewSessionGlyph,
  CloseGlyph,
} from '@latch/ui'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { useComputers } from '../core/computers.ts'
import { deviceAccess } from '../core/permissions.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'
import { computerName } from '../core/securityCopy.ts'
import { currentShell, type ComputersView } from '../core/shell.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import type { Space } from '../sessions.ts'
import { shortcutButtonKeys, shortcutKeys } from '../workbenchShortcuts.ts'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** The switch's state: the place shown (none on pages both places share), the way to a place, and where something waits. */
export interface SpacesProps {
  space: Space | null
  onSpace: (space: Space) => void
  waits: Record<Space, boolean>
}

/** The places' names and glyphs, wherever a way to them is drawn. */
const SPACE_LABELS: Record<Space, string> = { code: 'Code', agents: '我的 Agent' }

/** The place's glyph; `solid` where it is the place you are in. */
function SpaceGlyph({ space, size = 16, solid = false }: { space: Space; size?: 16 | 20; solid?: boolean }) {
  return <Icon icon={space === 'agents' ? AgentsGlyph : CodeGlyph} size={size} solid={solid} />
}

/** The amber dot on the other place while something waits for you there. */
const WAITS_TITLE: Record<Space, string> = { code: 'Code 里有等你处理的会话', agents: '我的 Agent 里有等你处理的会话' }

/**
 * Code | 我的 Agent across the top of the sidebar: two places, not a filter. Choosing one changes the primary action, the
 * list and the home page with it. The place you are not in carries an amber dot while something waits there.
 */
function SpaceSwitch({ space, onSpace, waits }: SpacesProps) {
  const option = (value: Space) => {
    const dot = waits[value] && value !== space
    return {
      value,
      label: SPACE_LABELS[value],
      // The dot rides the glyph's corner, as on the shut sidebar's buttons, so the place's name keeps its room.
      icon: (
        <span className="space-glyph">
          <SpaceGlyph space={value} solid={value === space} />
          {dot && <span className="space-dot" aria-hidden="true" />}
        </span>
      ),
      ...(dot ? { title: WAITS_TITLE[value] } : {}),
    }
  }
  return (
    <SegmentedControl
      className="space-switch"
      label="Code 与我的 Agent"
      size="md"
      value={space}
      options={[option('code'), option('agents')]}
      onValueChange={onSpace}
    />
  )
}

/**
 * The places as two icon buttons, where the sidebar is shut: the title row keeps the way between them in reach, with the
 * same amber dot.
 */
export function SpaceButtons({ space, onSpace, waits }: SpacesProps) {
  const desktop = currentShell() !== null
  return (
    <span className="space-buttons" role="group" aria-label="Code 与我的 Agent">
      {(['code', 'agents'] as const).map(value => {
        const dot = waits[value] && value !== space
        return (
          <IconButton
            key={value}
            label={SPACE_LABELS[value]}
            icon={value === 'agents' ? AgentsGlyph : CodeGlyph}
            pressed={value === space}
            {...(dot ? { tooltip: WAITS_TITLE[value], badge: <span className="space-dot" /> } : {})}
            {...(desktop ? { shortcut: value === 'code' ? '⇧⌘1' : '⇧⌘2' } : {})}
            onClick={() => {
              if (value !== space) onSpace(value)
            }}
          />
        )
      })}
    </span>
  )
}

/** The keys that press 新会话 or 搜索, as caps on the row; a drawer is for touch and narrow windows, so it has none. */
function capsOf(id: 'new' | 'palette', drawer: boolean) {
  const keys = drawer ? null : shortcutButtonKeys(id, currentShell() !== null)
  return keys ? { keys } : {}
}

/** Code's primary: 新会话, on (pressed) while the new-session page is open. */
export function NewSessionRow({ onNew, active, drawer }: { onNew: () => void; active: boolean; drawer: boolean }) {
  return (
    <Button
      variant="ghost"
      className="sidebar-nav-row"
      aria-label="新建会话"
      data-space-primary=""
      aria-pressed={drawer ? undefined : active}
      {...capsOf('new', drawer)}
      onClick={onNew}>
      <NewSessionGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      <span>新会话</span>
    </Button>
  )
}

/**
 * 我的 Agent's primary: 新建 Agent, on (pressed) while the creation page is open. A new topic starts from the space's 总览
 * (its input addresses an Agent) or from 话题 ▾, so the same key as 新会话 opens the 总览 with the input ready.
 */
function NewAgentRow({
  active,
  canRun,
  offline,
  onNew,
  compact = false,
}: {
  active: boolean
  canRun: boolean
  offline: boolean
  onNew: () => void
  /** The shut sidebar's title row and the top bar: an icon button. */
  compact?: boolean
}) {
  if (!canRun) return null
  return compact ? (
    <IconButton
      data-space-primary=""
      label="新建 Agent"
      icon={PlusGlyph}
      pressed={active}
      disabled={offline}
      tooltip={offline ? DEVICE_OFFLINE : undefined}
      onClick={onNew}
    />
  ) : (
    <Button
      variant="ghost"
      className="sidebar-nav-row"
      data-space-primary=""
      aria-pressed={active}
      disabled={offline}
      tooltip={offline ? DEVICE_OFFLINE : undefined}
      onClick={onNew}>
      <PlusGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      <span>新建 Agent</span>
    </Button>
  )
}

/**
 * The top of the sidebar on wide windows, the same in both places: the computer (where the page is not the Latch app on
 * it, or a menu of computers in the desktop app), the switch between the places, the place's primary and 搜索.
 */
export function NavTop({
  snapshot,
  spaces,
  primary,
  onSearch,
  drawer,
  onClose,
  computer,
  className,
  overview,
  onSchedules,
  computerAtFoot = false,
}: {
  snapshot: AppSnapshot
  /** Absent where the Host has no 我的 Agent: there is only Code, and no switch. */
  spaces?: SpacesProps | undefined
  primary: ReactNode
  onSearch: () => void
  drawer: boolean
  onClose?: (() => void) | undefined
  /** The computer popover with its trigger (`SidebarComputer`), given what the desktop app lists. */
  computer?: ((computers: ComputersView | undefined) => ReactNode) | undefined
  className?: string
  overview?: { active: boolean; open: () => void } | undefined
  onSchedules?: () => void
  computerAtFoot?: boolean
}) {
  const computers = useComputers()
  const several = computers !== undefined && computers.computers.length > 1
  // 「这台电脑」 is only the Latch app on the Host's own socket; a loopback browser is told which computer it is reading.
  const remote = !deviceAccess(snapshot, currentShell()).local
  return (
    <div className={className ? `sidebar-top ${className}` : 'sidebar-top'}>
      {!computerAtFoot
        && (several || remote)
        && (computer ? (
          computer(computers)
        ) : (
          <p className="sidebar-host" title={computerName(snapshot.hostName)}>
            <LaptopGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <span className="sidebar-host-name">{computerName(snapshot.hostName)}</span>
          </p>
        ))}
      {spaces && (
        <div className="sidebar-nav-line">
          <SpaceSwitch {...spaces} />
          {drawer && onClose && <IconButton label="关闭会话列表" icon={CloseGlyph} onClick={onClose} />}
        </div>
      )}
      {overview && (
        <Button variant="ghost" className="sidebar-nav-row" icon={OverviewGlyph} aria-pressed={overview.active} onClick={overview.open}>
          总览
        </Button>
      )}
      <div className="sidebar-nav-line">
        {primary}
        {drawer && onClose && !spaces && <IconButton label="关闭会话列表" icon={CloseGlyph} onClick={onClose} />}
      </div>
      <Button variant="ghost" className="sidebar-nav-row" aria-label="搜索" {...capsOf('palette', drawer)} onClick={onSearch}>
        <SearchGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        <span>搜索</span>
      </Button>
      {onSchedules && (
        <Button variant="ghost" className="sidebar-nav-row" icon={ScheduleGlyph} onClick={onSchedules}>
          定时任务
        </Button>
      )}
    </div>
  )
}

/** Something wrong with reaching the Mac: the sentence for the dot beside 设置, and how bad it is. A healthy state has none. */
export function connectionTrouble(
  connection: ConnectionStatus,
  hostProblem: { text: string } | null,
): { tone: 'warn' | 'error'; text: string } | null {
  if (connection === 'offline') return { tone: 'warn', text: DEVICE_OFFLINE }
  if (hostProblem) return { tone: 'error', text: hostProblem.text }
  if (connection === 'reconnecting') return { tone: 'warn', text: '正在重新连接' }
  return null
}

/**
 * The foot, shared by both places and always in reach: one row of icons. At the left 设置 (an amber or red dot while
 * the Mac cannot be reached as it should, the sentence on hover), 额度与用量 and 应用 where plugin pages are applied;
 * the keep-awake mark after them; 检查更新 at the right end.
 */
export function NavFoot({
  apps,
  quota,
  settings,
  trouble,
  awake,
  update,
}: {
  apps?: { current: boolean; onOpen: () => void } | undefined
  quota?: ReactNode
  settings?: (() => void) | undefined
  trouble: { tone: 'warn' | 'error'; text: string } | null
  awake?: ReactNode
  update?: ReactNode
}) {
  const keys = shortcutKeys('settings', currentShell() !== null) ?? undefined
  return (
    <nav className="sidebar-foot" aria-label="主导航">
      {settings ? (
        <IconButton
          label="设置"
          icon={SettingsGlyph}
          shortcut={keys}
          onClick={settings}
          {...(trouble ? { tooltip: `设置 · ${trouble.text}`, badge: <span className="icon-dot" data-tone={trouble.tone} /> } : {})}
        />
      ) : (
        trouble && (
          <span className="icon-dot" data-tone={trouble.tone} role="status" title={trouble.text}>
            <span className="sr-only">{trouble.text}</span>
          </span>
        )
      )}
      {quota}
      {apps && <IconButton label="应用" icon={PluginsGlyph} aria-current={apps.current ? 'page' : undefined} onClick={apps.onOpen} />}
      {awake}
      <span className="sidebar-foot-spacer" />
      {update}
    </nav>
  )
}

/** The switch's state and way, where the Host has 我的 Agent. */
export function shellSpaces(shell: Pick<ShellState, 'entries' | 'space' | 'goSpace' | 'waits' | 'route'>): SpacesProps | undefined {
  if (!shell.entries.includes('agents')) return undefined
  // 应用 belongs to both places: either segment goes back to its own place.
  const shared = shell.route.entry === 'apps'
  return { space: shared ? null : shell.route.start ? 'code' : shell.space, onSpace: shell.goSpace, waits: shell.waits }
}

/** 新建 Agent as the shell draws it: the sidebar's row, or an icon button where there is no room for one. */
export function ShellNewAgent({ shell, compact = false }: { shell: ShellState; compact?: boolean }) {
  return (
    <NewAgentRow
      active={shell.route.entry === 'agents' && shell.route.myAgent?.id === 'new'}
      canRun={shell.access.scopes.has('run') && shell.snapshot.device.dataScope === 'all'}
      offline={shell.connection === 'offline'}
      compact={compact}
      onNew={() => {
        shell.openMyAgent({ id: 'new' })
      }}
    />
  )
}

/** 总览 in the sidebar's top rows: 我的 Agent's own; Code has none (新会话 is its start screen). */
export function shellOverview(
  shell: Pick<ShellState, 'space' | 'route' | 'entries' | 'openMyAgent'>,
): { active: boolean; open: () => void } | undefined {
  const { route } = shell
  if (!shell.entries.includes('agents') || shell.space !== 'agents' || route.start) return undefined
  return {
    active: route.entry === 'agents' && route.myAgent === undefined && !route.topics,
    open: () => {
      shell.openMyAgent()
    },
  }
}

/** The foot as the shell draws it, from any of the sidebar's places. */
export function ShellNavFoot({ shell }: { shell: ShellState }) {
  return (
    <NavFoot
      apps={shell.entries.includes('apps') ? { current: shell.route.entry === 'apps', onOpen: () => shell.openApp() } : undefined}
      quota={shell.access.scopes.has('view') ? <UsageEntry /> : undefined}
      settings={shell.entries.includes('settings') ? () => shell.goEntry('settings') : undefined}
      trouble={connectionTrouble(shell.connection, shell.hostProblem)}
      update={<ShellUpdateCheck shell={shell} />}
    />
  )
}
